#tag Class
Protected Class Example
  #tag Method
  Private Shared Function Create(values() As String, _ // continuation
      Optional label As String = "(a,b)""quoted""") As MyModule.Result()
    Const LocalOnly = 42
    Soft Declare Function LocalNative Lib "test" () As Integer
    Var message As String = "#tag EndClass // End Function"
    Return Nil
  End Function
  #tag EndMethod

  #tag ComputedProperty
    #tag Getter
      Get
        Return mCount
      End Get
    #tag EndGetter
    #tag Setter
      Set
        mCount = value
      End Set
    #tag EndSetter
    Shared Count As Integer
  #tag EndComputedProperty
  #tag Property
    Private Names() As String
  #tag EndProperty
  #tag Hook
    Event Updated(value As Integer)
  #tag EndHook
  #tag DelegateDeclaration
    Delegate Sub Callback(value As MyModule.Result)
  #tag EndDelegateDeclaration
  #tag ExternalMethod
    Soft Declare Function Native Lib "test" Alias "native" (values() As Integer) As Ptr
  #tag EndExternalMethod
  #tag Enum, Name = LogLevel, Type = Integer, Flags = &h0
    Debug
    Warning = &h10
  #tag EndEnum
  #tag Structure, Name = Person
    FirstName As String
    Age As Integer
  #tag EndStructure
  #tag Constant, Name = Greeting, Type = String, Default = "hello, world"
  #tag EndConstant
  #tag Method
    Function HandleMenu() As Boolean Handles FileOpen.Action
      Return True
    End Function
  #tag EndMethod
  #tag Note
    #tag Method
    Function Fake() As Integer
    #tag EndMethod
  #tag EndNote
  #tag ViewBehavior
    #tag ViewProperty
      Name = "Hidden"
      FakeProperty As Integer
    #tag EndViewProperty
  #tag EndViewBehavior
End Class
#tag EndClass
